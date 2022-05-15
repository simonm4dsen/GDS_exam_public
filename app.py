import streamlit as st
import pandas as pd
import geopandas as gpd
import leafmap.colormaps as cm
import pydeck as pdk
import matplotlib.pyplot as plt
import numpy as np

from matplotlib.patches import Rectangle

from leafmap.common import hex_to_rgb
from dawa_scrape_prod import DAWA_data

from shapely.geometry import Point
from shapely.ops import nearest_points


plt.rcParams.update({
    #"figure.facecolor":  (1.0, 0.0, 0.0, 0.3),  # red   with alpha = 30%
    #"axes.facecolor":    (0.0, 1.0, 0.0, 0.5),  # green with alpha = 50%
    "savefig.facecolor": (0.0, 0.0, 0.0, 0),  # blue  with alpha = 20%
})

COLOR = 'white'
plt.rcParams['text.color'] = COLOR
plt.rcParams['axes.labelcolor'] = COLOR
plt.rcParams['xtick.color'] = COLOR
plt.rcParams['ytick.color'] = COLOR

def custom_round(x, base=5):
    return int(round(float(x*100)/base))

@st.cache(allow_output_mutation=True)
def get_data(limit=None):
    #read scraped data in
    #df = pd.read_csv('data/final_final_data.csv', sep=';').drop(['Unnamed: 0','Unnamed: 0.1'],axis=1)
    gdf = gpd.read_file('data/final_geodataframe_v2.geojson')

    if limit:
        gdf = gdf.head(limit)

    #convert adjusted_sqm_price to thousand separated integer (string)
    gdf['tooltip_price'] = gdf['adjusted_sqm_price'].astype(int)
    gdf['tooltip_price'] = gdf['tooltip_price'].map('{:,.2f}'.format)

    #strip apartment identifier and store just address for tooltip
    gdf['tooltip_address'] = [a.strip().split(',')[0] for a in gdf['address'].values.tolist()]

    #scale price to get elevation right for plot
    gdf['scaled_adjusted_sqm_price']=(gdf['adjusted_sqm_price']-gdf['adjusted_sqm_price'].min())/(gdf['adjusted_sqm_price'].max()-gdf['adjusted_sqm_price'].min())

    gdf['color_int'] = gdf['scaled_adjusted_sqm_price'].apply(lambda x: custom_round(x,base=5))
    return gdf

@st.cache
def get_postnumre():
    gdf = gpd.read_file('data/filtered_postnumre.geojson')
    return gdf

@st.cache
def get_sogne():
    gdf = gpd.read_file('data/sogne.geojson')
    return gdf


def pd_column_to_pretty(pd_column):
    d = {'square_meters_price':'Price m\u00b2',
        'adjusted_sqm_price': 'Adj. price m\u00b2'
    }
    return d[pd_column]


def main():

    st.set_page_config(layout="wide")

    st.markdown("<h1 style='text-align: center; color: White;'>Copenhagen Housing</h1>", unsafe_allow_html=True)
    st.write('')

    st.markdown("""
    <div>
      <input type="checkbox" name="uchk">
      <label for="uchk">Check CRS's for parish & municipalities.</label>
    </div>

    <div>
      <input type="checkbox" name="uchk">
      <label for="uchk">Create new github with the final data and a notebook that shows how the data was constructed</label>
    </div>
    """, unsafe_allow_html=True)
        
    
    #  <div>
    #   <input type="checkbox" name="chk" checked>
    #   <label for="chk">Checked.</label>
    # </div> 
    
    space = [st.write('') for i in range(2)]

    #tabs for sidebar
    pages = ['Home','Search']

    #chosen tab
    page_choice = st.sidebar.radio("Menu",pages)

    #fetch data - we can put this inside the if later
    gdf = get_data(limit=5000)

    #if home page is selected
    if page_choice == 'Home':
        
        postals = gdf.postal.unique()
        years = sorted(gdf.year.unique())

        min_y, max_y = min(years),max(years)

        c1,space,c2,space,c3,space,c4= st.columns((1,.125,1,.125,1,.125,1))

        space, button = st.columns((1,1.15))

        #year_slider
        year_filter = c1.select_slider("Data from: ",options=years,value=(min_y,max_y))
        
        #attribute dropdown
        attribute = c2.selectbox("Attribute",options=['adjusted_sqm_price','square_meters_price'],format_func=pd_column_to_pretty,index=0)
        
        #scale for plot
        scale = c3.selectbox("Scale",options=['Individual Apartments','Postal Codes','Parish (Sogn)'])

        #fetch available palettes and display in dropdown
        palettes = cm.list_colormaps()
        palette = c4.selectbox("Color Palette",options=palettes,index=2)

        #convert chosen palette to colors
        colors = cm.get_palette(palette,21)
        colors = [hex_to_rgb(c) for c in colors]

        #search button
        go = button.button('Plot ')

        if go:

            #filter the dataframe by selected year range
            gdf = gdf[(gdf['year'] >= year_filter[0]) & (gdf['year'] <= year_filter[1])]

            #let view be the same no matter the plot
            view = pdk.ViewState(
            latitude=55.67, longitude=12.56, zoom=9, max_zoom=18, pitch=0, bearing=0
            )

            if scale == 'Individual Apartments':

                gdf['color_rgb'] = [colors[i-1] for i in gdf['color_int'].values.tolist()]

                column_layer = pdk.Layer(
                    "ColumnLayer",
                    data=gdf,
                    get_position=["lng", "lat"],
                    get_elevation=attribute,
                    elevation_scale=.02,
                    radius=50,
                    extruded =True,
                    #get_fill_color=[255,255,"attribute/1000"],
                    get_fill_color = "color_rgb",
                    #[180, 0, 200, 140],
                    #[255, "square_meters_price/100", "square_meters_price/10000", 140],
                    opacity = 1,
                    pickable=True,
                    auto_highlight=True,
                )

                tooltip = {
                    "html": "<b>{tooltip_address}</b> <br> {tooltip_price} price pr sq meter",
                    "style": {"background": "grey", "color": "white", "font-family": '"Helvetica Neue", Arial', "z-index": "10000"},
                }


                r = pdk.Deck(
                    column_layer,
                    initial_view_state=view, 
                    tooltip=tooltip,
                    map_provider="carto",
                )
    
        
            elif scale == 'Postal Codes':
                
                post = get_postnumre().drop('id',axis=1)

                grouped = gdf.groupby(['postal','kommune']).agg({'adjusted_sqm_price':['mean','median']}).reset_index()
            
                grouped['postal'] = grouped['postal'].astype(str)
                post['POSTNR_TXT'] = post['POSTNR_TXT'].astype(str)

                grouped = post.merge(grouped,left_on='POSTNR_TXT',right_on='postal')

                grouped.columns = ['city','postal','geometry','drop_1','drop_2','adjusted_sqm_price_mean','adjusted_sqm_price_median']
                grouped = grouped.drop(['drop_1','drop_2'],axis=1)
     
                #max_median = grouped.adjusted_sqm_price_median.max()
                #min_median = grouped.adjusted_sqm_price_median.min()

                grouped['scaled_adjusted_sqm_price']=(grouped['adjusted_sqm_price_median']-grouped['adjusted_sqm_price_median'].min())/(grouped['adjusted_sqm_price_median'].max()-grouped['adjusted_sqm_price_median'].min())

                grouped['color_int'] = grouped['scaled_adjusted_sqm_price'].apply(lambda x: custom_round(x,base=5))
                grouped['color_rgb'] = [colors[i] for i in grouped['color_int'].values.tolist()]

                #convert adjusted_sqm_price to thousand separated integer (string)
                grouped['tooltip_price'] = grouped['adjusted_sqm_price_median'].astype(int)
                grouped['tooltip_price'] = grouped['tooltip_price'].map('{:,.0f}'.format)

                geojson = pdk.Layer(
                "GeoJsonLayer",
                #"ColumnLayer",
                grouped,
                #id="geojson",
                pickable=True,
                opacity=0.5,
                stroked=True,
                filled=True,
                extruded=True,
                wireframe=True,
                get_elevation='adjusted_sqm_price_median',
                #get_elevation = '',
                elevation_scale=.15,
                # get_fill_color="color",
                #get_fill_color=color_exp,
                get_fill_color="color_rgb",
                get_line_color=[0, 0, 0],
                get_line_width=2,
                line_width_min_pixels=1,
                )

                
                tooltip = {
                    "html": "<b>{city}</b> <br> {tooltip_price} price pr sq meter",
                    "style": {"background": "grey", "color": "white", "font-family": '"Helvetica Neue", Arial', "z-index": "10000"},
                }


                r = pdk.Deck(
                    layers =[geojson],
                    initial_view_state=view,
                    #pdk.data_utils.compute_view(gdf[["lng", "lat"]]),
                    map_provider="carto",
                    tooltip=tooltip,
                )


            elif scale == 'Parish (Sogn)':

                sogne = get_sogne()

                grouped = gdf.groupby(['sognekode']).agg({'adjusted_sqm_price':['mean','median']}).reset_index()
            
                grouped['SOGNEKODE'] = grouped['sognekode'].astype(str)
                
                sogne['SOGNEKODE'] = sogne['SOGNEKODE'].astype(str)
                
                grouped = sogne.merge(grouped,left_on=['SOGNEKODE'],right_on=['sognekode'])

                grouped.columns = ['drop_1','sognekode','sognenavn','geometry','drop_2','adjusted_sqm_price_mean','adjusted_sqm_price_median','drop_3']
                grouped = grouped.drop(['drop_1','drop_2','drop_3'],axis=1)

                grouped['scaled_adjusted_sqm_price']=(grouped['adjusted_sqm_price_median']-grouped['adjusted_sqm_price_median'].min())/(grouped['adjusted_sqm_price_median'].max()-grouped['adjusted_sqm_price_median'].min())

                grouped['color_int'] = grouped['scaled_adjusted_sqm_price'].apply(lambda x: custom_round(x,base=5))
                grouped['color_rgb'] = [colors[i-1] for i in grouped['color_int'].values.tolist()]

                max_median = grouped.adjusted_sqm_price_median.max()
                min_median = grouped.adjusted_sqm_price_median.min()

                grouped['color'] = (grouped['adjusted_sqm_price_median']-min_median)/(max_median-min_median)*255
                grouped['color'] = grouped['color'].astype(int)

                #convert adjusted_sqm_price to thousand separated integer (string)
                grouped['tooltip_price'] = grouped['adjusted_sqm_price_median'].astype(int)
                grouped['tooltip_price'] = grouped['tooltip_price'].map('{:,.0f}'.format)
           
                geojson = pdk.Layer(
                "GeoJsonLayer",
                #"ColumnLayer",
                grouped,
                #id="geojson",
                pickable=True,
                opacity=0.5,
                stroked=True,
                filled=True,
                extruded=True,
                wireframe=True,
                get_elevation='adjusted_sqm_price_median',
                #get_elevation = '',
                elevation_scale=.15,
                # get_fill_color="color",
                #get_fill_color=color_exp,
                get_fill_color="color_rgb",
                get_line_color=[0, 0, 0],
                get_line_width=2,
                line_width_min_pixels=1,
                )

                tooltip = {
                    "html": "<b>{sognenavn}</b> <br> {tooltip_price} price pr sq meter",
                    "style": {"background": "grey", "color": "white", "font-family": '"Helvetica Neue", Arial', "z-index": "10000"},
                }

                r = pdk.Deck(
                    layers =[geojson],
                    initial_view_state=view,
                    map_provider="carto",
                    tooltip=tooltip,
                )


            #columns for plot and colorbar
            mapp, color_bar = st.columns((1,.125))

            #fetch max and min values for colorbar ticks
            min_value = gdf[attribute].min()
            max_value = gdf[attribute].max()

            #plot the mao
            mapp.pydeck_chart(r)

            #show the colorbar
            color_bar.write(
                cm.create_colormap(
                    palette,
                    label=attribute.replace("_", " ").title(),
                    width=0.2,
                    height=3,
                    orientation="vertical",
                    vmin=min_value,
                    vmax=max_value,
                    font_size=8,
                )
            )


    elif page_choice == 'Search':
        
        #search bar and dropdowns here
        first_row = st.columns((2.5,.125,1.5,.125,1.5,.125,1))

        #search bar
        text = first_row[0].text_input("Type address",placeholder='... Kongens Nytorv 1, 1050 København K')

        #dropdowns in first_row
        min_addresses = first_row[2].selectbox("Min. adjacent addresses",options=[i for i in range(1,26)],index=4)
        min_apartments = first_row[4].selectbox("Min. number of Apartments",options=[i for i in range(10,101,10)],index=4)

        #fetch available palettes and display in dropdown
        palettes = cm.list_colormaps()
        palette = first_row[-1].selectbox("Color Palette",options=palettes,index=2)

        #convert chosen palette to colors
        colors = cm.get_palette(palette,21)
        colors = [hex_to_rgb(c) for c in colors]

        space, button = st.columns((1,1.15))

        go = button.button("Search",help='Type in address and search')

        st.markdown('---')

        if go:

            addr, confidence, lng, lat = DAWA_data(text)

            temp_string = 'Matched {} to address: {}'.format(text,addr)
            print_string = "<h6 style='text-align: center; color: White;'>{}</h3>".format(temp_string)

            st.markdown(print_string, unsafe_allow_html=True)
            st.markdown("---")

            #to print addresses later
            second_row = st.columns((1,1,1))
            second_row_extended = second_row*100

            points = [(lat,lng),]
            points_set = set()

            points_set.add((lat,lng))

            new_dataframe = pd.DataFrame()

            search_gdf = gdf.copy()

            search_gdf['lnglat'] = search_gdf['lng'].astype(str) + ',' + search_gdf['lat'].astype(str)

            count = 0

            total_condos = 0

            #while len(points) <= min_addresses:
            while count <  min_apartments+1 or len(points)<= min_addresses:
                
                current_length = len(search_gdf)

                #if we have one point, the point's index is 0
                #so len(points) - 1 is curr_point_index
                curr_point_index = len(points) - 1

                #this is the current point (lat,lng)
                curr_point = points[curr_point_index]

                #get the nearest points to curr_point
                neighborhood = search_gdf.sindex.nearest(curr_point)

                #neighbors = [x for x in neighborhood]

                #num_neighbors = len(neighbors)

                for i in neighborhood:
                    count += 1
                    row = search_gdf.iloc[[i]]

                    #store lat, lng
                    lati = float(row['lat'])
                    longi = float(row['lng'])

                    #point = row['latlng']

                    #check if the address has already been traversed
                    if (longi,lati) not in points_set:

                        add = row['address'].values.tolist()[0].strip().split(',')[0]


                        lat_filter = row['lat'].values.flatten().tolist()[0]
                        long_filter = row['lng'].values.flatten().tolist()[0]

                        num_condos = current_length - len(search_gdf[(search_gdf['lat'] != lat_filter) & (search_gdf['lat'] != long_filter)])
                        total_condos += num_condos
                        
                        if num_condos == 1:
                            s = 'apartment'
                        else:
                            s = 'apartments'

                        second_row_extended[len(points)-1].write('{} {} sold at \t{}'.format(num_condos,s,add))
                        
                        #if it hasn't, put it in the points_set
                        #and points
                        points.append((longi,lati))
                        points_set.add((longi,lati))


                    #append the apartment to new_dataframe
                    new_dataframe = new_dataframe.append(row)

                filter_points = [','.join(map(str, tup)) for tup in points_set] 

                search_gdf = search_gdf[~search_gdf['lnglat'].isin(filter_points)]


            #scale price to get elevation right for plot
            new_dataframe['scaled_adjusted_sqm_price']=(new_dataframe['adjusted_sqm_price']-new_dataframe['adjusted_sqm_price'].min())/(new_dataframe['adjusted_sqm_price'].max()-new_dataframe['adjusted_sqm_price'].min())

            new_dataframe['color_int'] = new_dataframe['scaled_adjusted_sqm_price'].apply(lambda x: custom_round(x,base=5))
            new_dataframe['color_rgb'] = [colors[i] for i in new_dataframe['color_int'].values.tolist()]

            #convert adjusted_sqm_price to thousand separated integer (string)
            new_dataframe['tooltip_price'] = new_dataframe['adjusted_sqm_price'].astype(int)
            new_dataframe['tooltip_price'] = new_dataframe['tooltip_price'].map('{:,.0f}'.format)

            #strip apartment identifier and store just address for tooltip
            new_dataframe['tooltip_address'] = [a.strip().split(',')[0] for a in new_dataframe['address'].values.tolist()]
            
            temp_string = '{} apartments on {} different addresses'.format(count,len(points))
            print_string = "<h3 style='text-align: center; color: White;'>{}</h3>".format(temp_string)

            st.markdown("---")
            st.markdown(print_string, unsafe_allow_html=True)

            view = pdk.ViewState(
            latitude=lng, longitude=lat, zoom=15, max_zoom=18, pitch=45, bearing=0
            )

            column_layer = pdk.Layer(
                "ColumnLayer",
                data=new_dataframe,
                get_position=["lng", "lat"],
                get_elevation="scaled_adjusted_sqm_price",
                elevation_scale=250,
                radius=4,
                get_fill_color="color_rgb",#/1000
                #[180, 0, 200, 140],
                #[255, "square_meters_price/100", "square_meters_price/10000", 140],
                pickable=True,
                auto_highlight=True,
            )

            tooltip = {
                "html": "<b>{tooltip_address}</b> <br> {tooltip_price} price pr sq meter",
                "style": {"background": "grey", "color": "white", "font-family": '"Helvetica Neue", Arial', "z-index": "10000"},
            }


            r = pdk.Deck(
                column_layer,
                initial_view_state=view, 
                tooltip=tooltip,
                map_provider="carto",
            )

            st.pydeck_chart(r)

        


if __name__ == '__main__':
    main()